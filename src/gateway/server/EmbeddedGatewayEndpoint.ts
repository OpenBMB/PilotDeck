import type { Gateway } from "../protocol/types.js";
import {
  GatewayWsConnection,
  type GatewayTextConnection,
} from "./GatewayWsConnection.js";

/**
 * Structural contract consumed by `@pilotdeck/sdk/embedded`. The endpoint
 * intentionally speaks the normal Gateway wire protocol, keeping every
 * request routed through the authoritative Gateway dispatcher.
 */
export type EmbeddedGatewayEndpoint = {
  sendToGateway(message: string): void;
  onGatewayMessage(listener: (message: string) => void): () => void;
  onGatewayClose(listener: () => void): () => void;
  close(): void;
};

export type CreateEmbeddedGatewayEndpointOptions = {
  gateway: Gateway;
  token: string;
  serverVersion?: string;
};

/**
 * Creates a local-only Gateway protocol endpoint without binding a TCP port
 * or creating a WebSocket server. Closing it follows the same in-flight turn
 * abort rule as a disconnected WebSocket client.
 */
export function createEmbeddedGatewayEndpoint(
  options: CreateEmbeddedGatewayEndpointOptions,
): EmbeddedGatewayEndpoint {
  return new InMemoryGatewayEndpoint(options);
}

class InMemoryGatewayEndpoint implements EmbeddedGatewayEndpoint {
  private readonly inboundHandlers = new Set<(message: string) => void>();
  private readonly gatewayMessageListeners = new Set<(message: string) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private closed = false;

  constructor(options: CreateEmbeddedGatewayEndpointOptions) {
    const connection: GatewayTextConnection = {
      onMessage: (handler) => this.inboundHandlers.add(handler),
      onClose: (handler) => this.closeHandlers.add(handler),
      sendText: (message) => this.emitGatewayMessage(message),
      close: () => this.close(),
    };
    // Keep the server dispatcher alive through the registered connection
    // callbacks; it owns request validation, error mapping and stream finals.
    new GatewayWsConnection(connection, {
      gateway: options.gateway,
      token: options.token,
      serverVersion: options.serverVersion ?? "embedded",
    });
  }

  sendToGateway(message: string): void {
    if (this.closed) throw new Error("Embedded Gateway endpoint is closed.");
    for (const handler of this.inboundHandlers) handler(message);
  }

  onGatewayMessage(listener: (message: string) => void): () => void {
    this.gatewayMessageListeners.add(listener);
    return () => this.gatewayMessageListeners.delete(listener);
  }

  onGatewayClose(listener: () => void): () => void {
    this.closeHandlers.add(listener);
    return () => this.closeHandlers.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
    this.closeHandlers.clear();
    this.inboundHandlers.clear();
    this.gatewayMessageListeners.clear();
  }

  private emitGatewayMessage(message: string): void {
    if (this.closed) return;
    queueMicrotask(() => {
      if (this.closed) return;
      for (const listener of this.gatewayMessageListeners) listener(message);
    });
  }
}
