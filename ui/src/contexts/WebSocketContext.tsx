import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';

type WSSubscriber = (msg: any) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => void;
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
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const subscribersRef = useRef<Set<WSSubscriber>>(new Set());
  const { token } = useAuth();

  useEffect(() => {
    connect();
    
    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [token]); // everytime token changes, we reconnect

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');
      
      const websocket = new WebSocket(wsUrl);

      websocket.onopen = () => {
        setIsConnected(true);
        wsRef.current = websocket;
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
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
        try {
          const data = JSON.parse(event.data);
          // Synchronously fan out to subscribers BEFORE the React state
          // update. React 18 auto-batches setLatestMessage across multiple
          // onmessage calls in the same task, so consumers that need every
          // single message (e.g. stream_delta accumulators) must subscribe
          // here instead of reading `latestMessage`.
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
        setIsConnected(false);
        wsRef.current = null;
        
        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [token]); // everytime token changes, we reconnect

  const sendMessage = useCallback((message: any) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
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
