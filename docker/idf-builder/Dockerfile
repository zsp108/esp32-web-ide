FROM espressif/idf:v5.5.5

ENV DEBIAN_FRONTEND=noninteractive

# Pre-install idf-component-manager for fetching third-party components (using Tsinghua PyPI mirror)
RUN pip install -i https://pypi.tuna.tsinghua.edu.cn/simple --no-cache-dir idf-component-manager

COPY compile.sh /compile.sh
RUN chmod +x /compile.sh
WORKDIR /src
ENTRYPOINT ["/compile.sh"]
