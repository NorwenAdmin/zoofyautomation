# For the throwaway "mock" test stack only — production deploy still uses the venv+systemd
# path in deploy/deploy.sh, this image is not used there.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
