import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';

type WSSubscriber = (msg: any) => void;

export type ReconnectInfo = {
  attempt: number;
  nextRetryMs: number;
  status: 'connected' | 'disconnected' | 'reconnecting';
};

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => void;
  latestMessage: any | null;
  isConnected: boolean;
  reconnectInfo: ReconnectInfo;
  /**
   * Subscribe to every incoming WebSocket message synchronously, bypassing
   * React state batching. Returns an unsubscribe function. Use this for
   * high-frequency event streams (chat stream_delta, etc.) where dropping
   * intermediate values is not acceptable. For low-frequency one-shot events
   * the `latestMessage` state is still fine.
   */
  subscribe: (handler: WSSubscriber) => () => void;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM || !token) return `${protocol}//${window.location.host}/ws`;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
};

const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;
const BACKOFF_FACTOR = 2;
const MAX_QUEUED_MESSAGES = 100;

export function getQueuedMessageKey(message: any): string | null {
  if (message?.type === 'check-session-status' && typeof message.sessionId === 'string' && message.sessionId.trim()) {
    return `check-session-status:${message.sessionId.trim()}`;
  }
  return null;
}

export function isQueueableDisconnectedMessage(message: any): boolean {
  return getQueuedMessageKey(message) !== null;
}

export function enqueueDisconnectedMessage(queue: any[], message: any, maxQueuedMessages = MAX_QUEUED_MESSAGES): void {
  const key = getQueuedMessageKey(message);
  if (!key) return;
  const existingIndex = queue.findIndex((queuedMessage) => getQueuedMessageKey(queuedMessage) === key);
  if (existingIndex >= 0) {
    queue.splice(existingIndex, 1);
  }
  queue.push(message);
  if (queue.length > maxQueuedMessages) {
    queue.splice(0, queue.length - maxQueuedMessages);
  }
}

export function clearDisconnectedQueue(queue: any[]): void {
  queue.splice(0, queue.length);
}

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const connectIdRef = useRef(0);
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [reconnectInfo, setReconnectInfo] = useState<ReconnectInfo>({
    attempt: 0,
    nextRetryMs: 0,
    status: 'disconnected',
  });
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptRef = useRef(0);
  const queuedMessagesRef = useRef<any[]>([]);
  const subscribersRef = useRef<Set<WSSubscriber>>(new Set());
  const { token } = useAuth();

  useEffect(() => {
    unmountedRef.current = false;
    return () => { unmountedRef.current = true; };
  }, []);

  useEffect(() => {
    const id = ++connectIdRef.current;

    const connect = () => {
      if (unmountedRef.current || connectIdRef.current !== id) return;
      setReconnectInfo((prev) => ({ ...prev, status: 'reconnecting' }));
      try {
        const wsUrl = buildWebSocketUrl(token);
        if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

        const websocket = new WebSocket(wsUrl);

        websocket.onopen = () => {
          if (connectIdRef.current !== id) { websocket.close(); return; }
          setIsConnected(true);
          reconnectAttemptRef.current = 0;
          setReconnectInfo({ attempt: 0, nextRetryMs: 0, status: 'connected' });
          wsRef.current = websocket;

          while (queuedMessagesRef.current.length > 0 && websocket.readyState === WebSocket.OPEN) {
            const message = queuedMessagesRef.current.shift();
            websocket.send(JSON.stringify(message));
          }

          const pingInterval = setInterval(() => {
            if (websocket.readyState === WebSocket.OPEN) {
              websocket.send(JSON.stringify({ type: 'ping' }));
            }
          }, 30_000);
          websocket.addEventListener('close', () => clearInterval(pingInterval));

          if (hasConnectedRef.current) {
            const reconnectMsg = { type: 'websocket-reconnected', timestamp: Date.now() };
            const subs = subscribersRef.current;
            if (subs.size > 0) {
              subs.forEach((sub) => {
                try { sub(reconnectMsg); } catch {}
              });
            }
            setLatestMessage(reconnectMsg);
          }
          hasConnectedRef.current = true;
        };

        websocket.onmessage = (event) => {
          if (connectIdRef.current !== id) return;
          try {
            const data = JSON.parse(event.data);
            const subs = subscribersRef.current;
            if (subs.size > 0) {
              subs.forEach((sub) => {
                try {
                  sub(data);
                } catch (err) {
                  console.error('WebSocket subscriber error:', err);
                }
              });
            }
            setLatestMessage(data);
          } catch (error) {
            console.error('Error parsing WebSocket message:', error);
          }
        };

        websocket.onclose = () => {
          if (connectIdRef.current !== id) return;
          setIsConnected(false);
          wsRef.current = null;
          const attempt = ++reconnectAttemptRef.current;
          const delay = Math.min(
            INITIAL_RECONNECT_MS * Math.pow(BACKOFF_FACTOR, attempt - 1),
            MAX_RECONNECT_MS,
          );
          setReconnectInfo({ attempt, nextRetryMs: delay, status: 'disconnected' });
          reconnectTimeoutRef.current = setTimeout(() => {
            if (unmountedRef.current || connectIdRef.current !== id) return;
            connect();
          }, delay);
        };

        websocket.onerror = (error) => {
          console.error('WebSocket error:', error);
        };
      } catch (error) {
        console.error('Error creating WebSocket connection:', error);
      }
    };

    connect();

    return () => {
      connectIdRef.current++;
      clearDisconnectedQueue(queuedMessagesRef.current);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        wsRef.current = null;
      }
      setIsConnected(false);
    };
  }, [token]);

  const sendMessage = useCallback((message: any) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else if (isQueueableDisconnectedMessage(message)) {
      enqueueDisconnectedMessage(queuedMessagesRef.current, message);
      console.warn('WebSocket not connected');
    } else {
      console.warn('WebSocket not connected');
    }
  }, []);

  const subscribe = useCallback<WebSocketContextType['subscribe']>((handler) => {
    subscribersRef.current.add(handler);
    return () => {
      subscribersRef.current.delete(handler);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    latestMessage,
    isConnected,
    reconnectInfo,
    subscribe,
  }), [sendMessage, latestMessage, isConnected, reconnectInfo, subscribe]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();
  
  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
