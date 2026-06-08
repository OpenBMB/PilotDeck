import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';

type WSSubscriber = (msg: any) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => boolean;
  latestMessage: any | null;
  isConnected: boolean;
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

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const connectIdRef = useRef(0);
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const subscribersRef = useRef<Set<WSSubscriber>>(new Set());
  const { token } = useAuth();

  useEffect(() => {
    return () => { unmountedRef.current = true; };
  }, []);

  useEffect(() => {
    const id = ++connectIdRef.current;

    const connect = () => {
      if (unmountedRef.current || connectIdRef.current !== id) return;
      try {
        const wsUrl = buildWebSocketUrl(token);
        if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

        const websocket = new WebSocket(wsUrl);

        websocket.onopen = () => {
          if (connectIdRef.current !== id) { websocket.close(); return; }
          setIsConnected(true);
          wsRef.current = websocket;
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
          reconnectTimeoutRef.current = setTimeout(() => {
            if (unmountedRef.current || connectIdRef.current !== id) return;
            connect();
          }, 3000);
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
      try {
        socket.send(JSON.stringify(message));
        return true;
      } catch (error) {
        console.error('WebSocket send failed:', error);
        return false;
      }
    }
    console.warn('WebSocket not connected');
    return false;
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
    subscribe,
  }), [sendMessage, latestMessage, isConnected, subscribe]);

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
