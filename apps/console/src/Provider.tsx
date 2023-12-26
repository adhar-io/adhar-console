import React, { createContext, useState, ReactNode } from 'react';
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import routes from './Routes';

interface ContextState {
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
}

interface ProviderProps {
  children: ReactNode;
}

export const AppContext = createContext<ContextState | undefined>(undefined);

const router = createBrowserRouter(routes);

const Provider = ({ children }: ProviderProps) => {
  const [value, setValue] = useState<string>('Initial value');

  return (
    <AppContext.Provider value={{ value, setValue }}>
      <RouterProvider router={router} />
      {children}
    </AppContext.Provider>
  );
};

export default Provider;