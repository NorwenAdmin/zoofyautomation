from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://zoofyautomation:zoofyautomation@localhost:5435/zoofyautomation"
    session_secret: str = "dev-only-insecure-secret-change-me"
    # Shared secret n8n sends as X-API-Key when writing data — separate from user sessions
    # since n8n has no login, just a machine-to-machine credential.
    n8n_api_key: str = "dev-only-insecure-key-change-me"
    # Off by default so the mock/test stacks never make real network calls to Nominatim —
    # only the production .env turns this on.
    geocoding_enabled: bool = False


settings = Settings()
