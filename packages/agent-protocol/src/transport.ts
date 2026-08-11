export type MessageHandler<TMessage> = (message: TMessage) => void | Promise<void>;

export interface ProtocolTransport<TSend, TReceive> {
  send(message: TSend): Promise<void>;
  onMessage(handler: MessageHandler<TReceive>): () => void;
  close(): Promise<void>;
}

export function createInMemoryTransportPair<TA, TB>(): {
  a: ProtocolTransport<TA, TB>;
  b: ProtocolTransport<TB, TA>;
} {
  const aHandlers = new Set<MessageHandler<TB>>();
  const bHandlers = new Set<MessageHandler<TA>>();
  let aClosed = false;
  let bClosed = false;

  const a: ProtocolTransport<TA, TB> = {
    async send(message: TA): Promise<void> {
      if (aClosed) throw new Error("transport closed");
      for (const handler of [...bHandlers]) await handler(message);
    },
    onMessage(handler: MessageHandler<TB>): () => void {
      if (aClosed) throw new Error("transport closed");
      aHandlers.add(handler);
      return () => aHandlers.delete(handler);
    },
    async close(): Promise<void> {
      aClosed = true;
      aHandlers.clear();
    },
  };

  const b: ProtocolTransport<TB, TA> = {
    async send(message: TB): Promise<void> {
      if (bClosed) throw new Error("transport closed");
      for (const handler of [...aHandlers]) await handler(message);
    },
    onMessage(handler: MessageHandler<TA>): () => void {
      if (bClosed) throw new Error("transport closed");
      bHandlers.add(handler);
      return () => bHandlers.delete(handler);
    },
    async close(): Promise<void> {
      bClosed = true;
      bHandlers.clear();
    },
  };

  return { a, b };
}
