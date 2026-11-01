from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    database_url: str = "postgresql+psycopg://ucaselab:ucaselab@localhost:54329/ucaselab"
    public_url: str = "http://localhost:5173"
    allowed_origins: str = ""
    secret_key: str = ""
    encryption_key: str = ""
    cookie_secure: bool = False
    session_days: int = 14
    email_enabled: bool = True
    smtp_host: str = "localhost"
    smtp_port: int = 10259
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_starttls: bool = False
    smtp_from: str = "UCaseLab <noreply@localhost>"
    storage_path: str = "./data/attachments"
    max_upload_mb: int = 20
    allowed_hosts: str = "localhost,127.0.0.1,testserver"
    environment: str = "development"

    def validate_runtime(self):
        import base64

        if len(self.secret_key) < 32:
            raise RuntimeError("SECRET_KEY must contain at least 32 random characters")
        try:
            key = base64.urlsafe_b64decode(self.encryption_key)
            if len(key) != 32:
                raise ValueError()
        except Exception as exc:
            raise RuntimeError("ENCRYPTION_KEY must be a URL-safe base64 encoded 32-byte key") from exc
        if self.environment == "production" and (
            not self.cookie_secure or not self.public_url.startswith("https://")
        ):
            raise RuntimeError("Production requires HTTPS PUBLIC_URL and COOKIE_SECURE=true")


@lru_cache
def settings():
    return Settings()
