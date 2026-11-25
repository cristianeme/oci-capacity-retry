# oci-capacity-retry

Temporal. Cada 5 minutos, GitHub Actions intenta crear una VM Always Free `VM.Standard.A1.Flex` en Oracle Cloud (cuando no hay capacidad, Oracle responde "Out of host capacity").
Cuando la VM existe, abre un issue con la IP y desactiva el workflow.

- Script: `oci-launch.mjs` (sin dependencias; firma las llamadas a la API de OCI). Fuente: repo privado `ariba-rfp-analyzer-br`, `deploy/`.
- Secretos: `OCI_CONFIG` (archivo `~/.oci/config`) y `OCI_KEY` (clave privada de API). Variable: `SSH_PUBLIC_KEY`.
- Los logs no muestran datos de la cuenta (`QUIET=1`).

Al terminar: borrar este repo y la clave de API en la consola de Oracle (o rotarla).
