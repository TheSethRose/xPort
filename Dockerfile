FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system xport \
    && useradd --system --gid xport --home-dir /app --shell /usr/sbin/nologin xport

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY api ./api

EXPOSE 8080

USER xport

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["python", "-m", "api.xport_api"]
