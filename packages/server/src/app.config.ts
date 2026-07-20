import type { INestApplication } from "@nestjs/common";
import type { MessageMappingProperties } from "@nestjs/websockets/gateway-metadata-explorer";
import { WsAdapter } from "@nestjs/platform-ws";
import type { Observable } from "rxjs";

const CORS_METHODS = "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS";

export function configureApp(app: INestApplication): void {
  app.useWebSocketAdapter(new RealtimeWsAdapter(app));
  app.enableCors({
    methods: CORS_METHODS,
    origin: true,
  });
}

class RealtimeWsAdapter extends WsAdapter {
  bindMessageHandlers(
    _client: unknown,
    _handlers: MessageMappingProperties[],
    _transform: (data: unknown) => Observable<unknown>,
  ): void {
    // RealtimeGateway consumes raw WebSocket messages directly.
  }
}
