# ベースイメージとして、現在のLTS(長期サポート)版かつ安全な node:20-alpine を使用
FROM node:20-alpine

# Alpineのパッケージマネージャー'apk'を使い、必要なツールをインストール
RUN apk update && \
    apk add --no-cache \
    ffmpeg \
    python3 \
    py3-pip

# 1. Pythonの仮想環境を "/opt/venv" という場所に作成します
RUN python3 -m venv /opt/venv

# 2. 環境変数PATHの先頭に、作成した仮想環境のbinディレクトリを追加します。
# これにより、以降のコマンドは自動的に仮想環境内のpythonやpipを使うようになります。
ENV PATH="/opt/venv/bin:$PATH"

# 3. yt-dlpをインストールします。
# 上記のENV設定により、これは仮想環境内に安全にインストールされます。
RUN pip install -U yt-dlp

# アプリケーション用の作業ディレクトリを設定
WORKDIR /usr/src/app

# package.jsonをコピーして、本番用のnpmモジュールをインストール
COPY package*.json ./
RUN npm install --production

# アプリケーションのソースコードをコピー
COPY . .

# アプリケーションが使用するポートを公開
EXPOSE 3000

# サーバーを起動するコマンド
CMD [ "node", "server.js" ]
