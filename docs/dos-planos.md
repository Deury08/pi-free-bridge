# Los dos planos

El puente se rompe de dos maneras que no se parecen, y la razón es que hay dos
planos distintos: por dónde **sale el transporte** y con qué dirección **sale el
egreso**. Confundirlos hace que el diagnóstico apunte al lado equivocado.

## Transporte: IPv4 hacia el peer MASQUE

El relay abre su túnel CONNECT contra un literal IPv4: `162.159.198.1:443` es el
default del peer, y `162.159.198.2:443` es el que se observó en el log vivo
(`WARP masque tunnel up: endpoint=162.159.198.2:443`). Por eso el enlace puede
funcionar en una red sin ruta IPv6 y aun así servir tráfico: ese salto no
necesita IPv6 en ningún momento.

## Egreso: IPv6-only, y sale del túnel

La dirección que ve el mundo no es la del transporte: es la del exit, y esa es
IPv6-only. El reparto está sostenido en el código y en los tests: `relay.mjs`
trabaja siempre con la dirección de egreso, «never the device endpoint», y
`test/relay.test.mjs:4995` fija que «the tunnel is IPv6-only», de ahí que la
misma dirección llegue escrita de varias formas y haya que normalizarla.

Es decir: el túnel es IPv6-only *por dentro*; el salto que lo establece, no.

## Consecuencia práctica

Un problema del enlace y un problema de la salida dan síntomas distintos. Si el
transporte no conecta, el relay no tiene túnel: no hay exit, no hay respuesta, y
el fallo aparece de inmediato. Si el transporte está bien pero la salida no
sirve, el túnel existe y lo que falla es la dirección de egreso (rechazo del
stack IPv6-only, cuota agotada en el gate), y se ve como error de request sobre
un túnel que sí está arriba.

Se diagnostican por separado: primero el enlace, después la salida.

Las direcciones observadas y su contexto quedan registrados en
[`odd/tasks/warp-per-exit-quota.md`](../odd/tasks/warp-per-exit-quota.md).
