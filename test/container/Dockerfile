# A deliberately empty machine: no Bun, no Node, no OpenCode, no config.
# If the relay needs any of them, this image proves it.
FROM debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/relay
COPY clean-install.sh /opt/relay/clean-install.sh
RUN chmod +x /opt/relay/clean-install.sh

ENTRYPOINT ["/opt/relay/clean-install.sh"]
