import { useSyncExternalStore } from 'react';
import { connection, onConnection, type Connection } from '@/lib/connection';

export const useConnection = (): Connection => useSyncExternalStore(onConnection, connection, () => 'online');
