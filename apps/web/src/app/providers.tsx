import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { createApiClient, type ApiClient } from '../api/index.js';
import {
  createBrowserRealtime,
  RealtimeProvider,
  type Realtime,
} from '../realtime/index.js';
import { NavigationContext } from '../shared/ui/index.js';
import { navigate } from './router.js';

export interface AppServices {
  api: ApiClient;
  realtime: Realtime;
}
export function createAppServices(): AppServices {
  const api = createApiClient({
    onUnauthorized: () => {
      realtime.stop();
      realtime.store.setState({ auth: 'missing' });
    },
  });
  const realtime = createBrowserRealtime(api);
  return { api, realtime };
}
const ServicesContext = createContext<AppServices | null>(null);
export function useAppServices(): AppServices {
  const value = useContext(ServicesContext);
  if (!value) throw new Error('AppProviders is missing');
  return value;
}
export function AppProviders({
  children,
  services: supplied,
}: {
  children: ReactNode;
  services?: AppServices;
}) {
  const [services] = useState(() => supplied ?? createAppServices());
  useEffect(() => {
    let disposed = false;
    // A health probe distinguishes a valid cookie from an unavailable stream.
    void services.api
      .getHealth()
      .then(() => {
        if (disposed || services.realtime.store.getState().auth === 'missing')
          return;
        services.realtime.store.setState({ auth: 'ok' });
        return services.realtime.start();
      })
      .catch(() => {
        if (!disposed)
          services.realtime.store.setState((state) => ({
            connection: { ...state.connection, status: 'offline' },
          }));
      });
    return () => {
      disposed = true;
      services.realtime.stop();
    };
  }, [services]);
  return (
    <ServicesContext.Provider value={services}>
      <RealtimeProvider realtime={services.realtime}>
        <NavigationContext.Provider value={{ navigate }}>
          {children}
        </NavigationContext.Provider>
      </RealtimeProvider>
    </ServicesContext.Provider>
  );
}
