FROM mcr.microsoft.com/devcontainers/python:1-3.12-bookworm

# DashBar does not need the Yarn APT repository. Keep signature checks enabled.
RUN rm -f /etc/apt/sources.list.d/yarn.list /etc/apt/sources.list.d/yarn.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr poppler-utils fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
