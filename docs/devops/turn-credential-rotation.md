# TURN credential rotation playbook

This guide explains how to rotate the shared TURN password that the Charge backend
and the coturn service use for WebRTC authentication.

## Prerequisites

- Access to the production secret manager (or the host where `.env.local` is stored).
- Ability to restart the `api` and `turn` services in the target environment.
- Python 3.10+ available locally to run helper scripts.

## 1. Generate a new secret

Use the bundled helper to generate a high-entropy password. The `--silent` flag
prevents the value from being printed to stdout when you update a file in place.

```bash
python scripts/generate_turn_secret.py --update-env .env.local --silent
```

If the deployment uses a secret manager, run the script without `--update-env`
and paste the output directly into the manager:

```bash
python scripts/generate_turn_secret.py --bytes 64
```

## 2. Update the backend configuration

1. Set the `WEBRTC_TURN_CREDENTIAL` entry in the secret manager (or `.env.local`)
   to the newly generated value.
2. Redeploy the backend so the new credential is loaded, for example:

   ```bash
   docker compose --env-file .env.local up -d --force-recreate api
   ```

## 3. Update coturn

1. Ensure the same secret is available to the `turn` service (for example via the
   deployment secret manager or exported environment variables).
2. Recreate the container so `turnserver` picks up the change:

   ```bash
   docker compose --env-file .env.local up -d --force-recreate turn
   ```

   Restarting both `api` and `turn` in the same command avoids a mismatch window:

   ```bash
   docker compose --env-file .env.local up -d --force-recreate api turn
   ```

## 4. Validate the rotation

1. Run the TURN health probe from the backend directory:

   ```bash
   cd backend
   poetry run python -m app.services.turn_health --log-level INFO
   ```

2. Attempt a voice call from the staging environment to confirm new allocations
   succeed.
3. Monitor container logs to ensure the secret value is not echoed (the codebase
   strips credentials from operational logs, so no secret should appear).

## 5. Clean up

- Revoke the previous secret in the manager once all nodes have applied the new
  value.
- Update runbooks and tickets with the rotation timestamp.

Schedule rotations at least quarterly so leaked credentials cannot be abused for
long.
