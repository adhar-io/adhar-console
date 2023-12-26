import { StrictMode } from 'react';
import * as ReactDOM from 'react-dom/client';
import './styles/global.css';
import App from './App';
import Provider from './Provider';

const root = ReactDOM.createRoot(
  document.querySelector('#root') as HTMLElement
);

root.render(
  <StrictMode>
    <Provider>
      <App />
    </Provider>
  </StrictMode>
);
