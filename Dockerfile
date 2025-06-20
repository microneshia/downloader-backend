# ベースイメージとして、現在のLTS(長期サポート)版かつ安全な node:20-alpine を使用
# 警告は一時的なものである可能性が高く、これが依然として最善の選択肢です。
FROM node:20-alpine

# Alpineのパッケージマネージャー'apk'を使い、必要なツールをインストール
# --no-cache オプションでイメージサイズを最小限に抑える
RUN apk update && \
    apk add --no-cache \
    ffmpeg \
    python3 \
    py3-pip

# yt-dlpをインストール
RUN pip3 install -U yt-dlp

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