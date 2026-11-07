# Legacy Deployment Configuration

This directory contains the former shared-host deployment topology. It is retained only for lifecycle helpers and historical reference. Do not deploy SEP from this directory.

Production releases use [`deploy/standalone`](../standalone/README.md), the dedicated SEP server at `121.37.128.126`, and `https://sep.longdaoec.com`.

The former `/opt/sep` layout, shared PostgreSQL/Redis/Caddy instructions, and scripts that deploy the legacy Compose files are retired. The old standalone-independent entry point exits without making changes; `deploy/production/sep-deploy.sh` remains available only as a sourced lifecycle library for the standalone release script.
