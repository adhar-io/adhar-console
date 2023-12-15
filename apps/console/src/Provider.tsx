import React, { createContext, useState } from 'react';
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import routes from './Routes';

interface ContextState {
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
}

export const AppContext = createContext<ContextState | undefined>(undefined);

const router = createBrowserRouter(routes);

const Provider = ({children}) => {
  const [value, setValue] = useState<string>('Initial value');

  return (
    <AppContext.Provider value={{ value, setValue }}>
        <FluentProvider theme={webLightTheme}>
            <RouterProvider router={router}>
                {children}
            </RouterProvider>
        </FluentProvider>
    </AppContext.Provider>
  );
};

export default Provider;