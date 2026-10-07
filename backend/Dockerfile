FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.lock ./requirements.lock
RUN pip install --no-cache-dir -r requirements.lock
RUN groupadd --gid 10001 clinic && useradd --uid 10001 --gid clinic --create-home clinic
COPY --chown=clinic:clinic . .
RUN mkdir -p /app/media && chown clinic:clinic /app/media
USER clinic
EXPOSE 8000
CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
