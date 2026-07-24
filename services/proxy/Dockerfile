FROM golang:1.25-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o iot-observability-proxy .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /build/iot-observability-proxy .
EXPOSE 8090
ENTRYPOINT ["./iot-observability-proxy"]
