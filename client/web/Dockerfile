FROM nginx:1.27-alpine

# 复制 nginx 配置
COPY nginx.conf /etc/nginx/nginx.conf

# 下载管理页面（放在 dn/ 目录，与共享卷 /app/downloads/ 分离）
COPY downloads /usr/share/nginx/html/dn

# 创建上传文件挂载点
RUN mkdir -p /app/downloads

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
