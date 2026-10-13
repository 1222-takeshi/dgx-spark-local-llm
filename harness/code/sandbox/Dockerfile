FROM python:3.12-slim
RUN pip install --no-cache-dir numpy==2.3.3 scipy==1.16.2
# judge.py is mounted at /work at run time; the container runs with --network none and a read-only root
