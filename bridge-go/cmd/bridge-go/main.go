package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Deury08/pi-free-bridge/bridge-go/internal/egress"
	"github.com/Deury08/pi-free-bridge/bridge-go/internal/gate"
)

type Config struct {
	Listen         string `json:"listen"`
	Upstream       string `json:"upstream"`
	HealthPath     string `json:"health_path"`
	EgressStrategy string `json:"egress_strategy"`
	LocalCooldown  int    `json:"local_cooldown_minutes"`
	MaxAttempts    int    `json:"max_attempts"`
	WarpEnabled    bool   `json:"warp_enabled"`
	WarpPoolSize   int    `json:"warp_pool_size"`
	WarpStack      string `json:"warp_stack"`
}

func main() {
	configPath := flag.String("config", "config.json", "Path to config file")
	version := flag.Bool("version", false, "Print version and exit")
	flag.Parse()

	if *version {
		fmt.Println("bridge-go v0.1.0")
		return
	}

	cfg, err := loadConfig(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:8788"
	}
	if cfg.Upstream == "" {
		cfg.Upstream = "https://opencode.ai/inference/v1"
	}
	if cfg.HealthPath == "" {
		cfg.HealthPath = "/health"
	}
	if cfg.EgressStrategy == "" {
		cfg.EgressStrategy = "local_warp_local"
	}
	if cfg.LocalCooldown == 0 {
		cfg.LocalCooldown = 30
	}
	if cfg.MaxAttempts == 0 {
		cfg.MaxAttempts = 6
	}

	sessionMgr := gate.NewSessionManager(30 * time.Minute)
	toolAliaser := gate.NewToolAliaser()
	promptInjector := &gate.PromptInjector{CWD: getCWD()}
	errorMapper := &gate.ErrorMapper{}
	sseHandler := gate.NewSSEHandler(toolAliaser)

	coordinator, err := egress.NewCoordinator(egress.CoordinatorConfig{
		Strategy:      cfg.EgressStrategy,
		LocalCooldown: time.Duration(cfg.LocalCooldown) * time.Minute,
		MaxAttempts:   cfg.MaxAttempts,
		LocalConfig: egress.LocalConfig{
			CooldownDuration: time.Duration(cfg.LocalCooldown) * time.Minute,
		},
		WarpConfig: egress.WarpConfig{
			Enabled:    cfg.WarpEnabled,
			PoolSize:   cfg.WarpPoolSize,
			Stack:      cfg.WarpStack,
			SourceIPv6: "",
		},
	})
	if err != nil {
		log.Fatalf("create coordinator: %v", err)
	}
	defer coordinator.Close()

	mux := http.NewServeMux()
	mux.HandleFunc(cfg.HealthPath, healthHandler(coordinator))
	mux.HandleFunc("/v1/chat/completions", chatCompletionsHandler(coordinator, sessionMgr, toolAliaser, promptInjector, errorMapper, sseHandler, cfg.Upstream))

	server := &http.Server{
		Addr:         cfg.Listen,
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  120 * time.Second,
	}


	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("Shutdown signal received")
		context.Background()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("Server shutdown error: %v", err)
		}
	}()

	log.Printf("bridge-go listening on %s", cfg.Listen)
	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
	log.Println("Server stopped")
}

func loadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Config{}, nil
		}
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func getCWD() string {
	dir, err := os.Getwd()
	if err != nil {
		return "."
	}
	return dir
}

func healthHandler(coordinator *egress.Coordinator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		status := coordinator.HealthStatus()
		status["ok"] = true
		status["service"] = "bridge-go"
		json.NewEncoder(w).Encode(status)
	}
}

func chatCompletionsHandler(
	coordinator *egress.Coordinator,
	sessionMgr *gate.SessionManager,
	toolAliaser *gate.ToolAliaser,
	promptInjector *gate.PromptInjector,
	errorMapper *gate.ErrorMapper,
	sseHandler *gate.SSEHandler,
	upstream string,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		var reqBody map[string]any
		if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorMapper.Map(http.StatusBadRequest, err.Error()))
			return
		}

		holder := "default"
		if auth := r.Header.Get("Authorization"); auth != "" {
			holder = auth
		}
		session := sessionMgr.GetOrCreate(holder)

		if msgs, ok := reqBody["messages"].([]any); ok {
			msgsMap := make([]map[string]any, len(msgs))
			for i, m := range msgs {
				if mm, ok := m.(map[string]any); ok {
					msgsMap[i] = mm
				}
			}
			reqBody["messages"] = promptInjector.Inject(msgsMap)
		}

		var clientTools []gate.Tool
		if tools, ok := reqBody["tools"].([]any); ok {
			for _, t := range tools {
				if tt, ok := t.(map[string]any); ok {
					clientTools = append(clientTools, gate.Tool{
						Name:        getString(tt, "name"),
						Description: getString(tt, "description"),
						Parameters:  getMap(tt, "parameters"),
					})
				}
			}
		}
		aliasedTools, _ := toolAliaser.AliasTools(clientTools)
		reqBody["tools"] = aliasedTools

		reqHeaders := make(http.Header)
		for k, v := range r.Header {
			reqHeaders[k] = v
		}
		for k, v := range session.SessionHeaders() {
			reqHeaders.Set(k, v)
		}
		reqHeaders.Set("Authorization", "Bearer public")
		reqHeaders.Set("User-Agent", "opencode/latest/2.1.1/cli")
		reqHeaders.Set("Accept", "text/event-stream")
		reqHeaders.Set("Content-Type", "application/json")

		upstreamReq, err := http.NewRequestWithContext(ctx, http.MethodPost, upstream+"/chat/completions", nil)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorMapper.Map(http.StatusInternalServerError, err.Error()))
			return
		}
		upstreamReq.Header = reqHeaders

		bodyBytes, _ := json.Marshal(reqBody)
		upstreamReq.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		upstreamReq.ContentLength = int64(len(bodyBytes))

		resp, err, egressUsed := coordinator.RoundTrip(ctx, upstreamReq)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(errorMapper.Map(http.StatusBadGateway, err.Error()))
			return
		}
		defer resp.Body.Close()

		for k, vv := range resp.Header {
			for _, v := range vv {
				w.Header().Add(k, v)
			}
		}
		w.Header().Set("X-Egress-Used", egressUsed)
		w.WriteHeader(resp.StatusCode)

		io.Copy(w, resp.Body)
	}
}

func getString(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func getMap(m map[string]any, key string) map[string]any {
	if v, ok := m[key].(map[string]any); ok {
		return v
	}
	return nil
}
