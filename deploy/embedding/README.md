# Independent Knowledge Embedding Service

SEP application deployment never invokes this directory. This service has its own Compose project (`sep-embedding`), workflow (`Manage Embedding Service`), concurrency group, lock and data root (`/www/sep-embedding`). It shares only the existing private `sep-migration-net` network with SEP.

The workflow is manual. Choose `install` for the initial recovery. After the exact commit passes Quality Gates, Actions downloads official Ollama 0.40.16 and Node 22 images, records registry digests and image IDs, retags them with ID-derived local tags, exports them and sends a checksummed archive. The server validates image IDs after import; Compose uses those unique local tags with `--pull never`, bypassing its failing registry mirror. It validates the existing backend profile/tokenizer and database structure without changing them, pulls the fixed BGE-M3 model, checks the manifest and weight SHA256, runs isolated inference tests and only then attaches the service to the application network. Backend/frontend container identities and startup times must remain unchanged.

Choose `status` for read-only container information; it uploads no files. `verify` uses the installed probe for a small synthetic request. `stop` stops only Ollama and preserves all data. Successful installations are not reconfigured or upgraded by running `install` again. An owned installation that has not completed may resume with revised deployment files, preserving previous files in its evidence directory; no active model release is overwritten. Software/model upgrades require a separately reviewed procedure.

No port is published. Initial limits are 4 CPUs, 8 GiB memory, one loaded model and one parallel request. Container health checks API availability, while the probe checks the exact model, finite nonzero 1024-dimensional output, batching, oversized input rejection and cold loading. These checks do not establish production throughput or complete knowledge-base authorization acceptance.

The server's virtual CPU does not expose AVX/AVX2; the stock 0.40.16 inference runner raised SIGILL during isolated validation. `Dockerfile.cpu` retains the official Ollama server binary but rebuilds its pinned official llama.cpp-compatible runner for baseline x86-64 without AVX/FMA/F16C. The runtime is CPU-only and includes OpenBLAS. Both upstream source commits, build flags and the resulting image ID are recorded. Model weights and digest remain unchanged; deployment tests the resulting runner before production attachment.

If the candidate fails after network attachment, the installation script removes only its production network connection. It never restores an old database, rewrites model profiles, restarts application containers or prunes Docker. Keep `/www/sep-embedding/backups` evidence and model data for investigation.

The deployment does not automatically retry customer documents or rebuild historical indexes. Use the platform's normal authorized retry workflow after the model service passes validation.

Local checks (no production connection):

```bash
node --test deploy/embedding/verify-embedding.test.cjs
bash -n deploy/embedding/manage.sh
bash -n deploy/embedding/upload.sh
bash deploy/embedding/test-upload.sh
```

Configuration and logs may be stored in the server evidence directory. Do not publish production environment files or user document content in Actions artifacts.
