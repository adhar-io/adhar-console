import React from 'react';
import Topbar from '../components/Topbar';
import Footer from '../components/Footer';

const AppLayout = ({ children }) => {
  return (
    <main className="app-layout">
      <header className="app-header">
        <Topbar />
      </header>
      <div className="app-sidebar">Sidebar</div>
      <div className="app-main">{children}</div>
      <div className="app-drawer">Right Side Drawer</div>
      <footer>
        <Footer />
      </footer>
    </main>
  );
}

export default AppLayout;