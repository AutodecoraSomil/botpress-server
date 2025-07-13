FROM botpress/server:12.30.2

WORKDIR /botpress

COPY . .

EXPOSE 3000

CMD ["./bp"]
