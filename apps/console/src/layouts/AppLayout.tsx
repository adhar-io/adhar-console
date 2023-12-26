import React from 'react';
import SideBar from '@/patterns/sidebar';
import AppFooter from '@/patterns/app-footer';
import AppHeader from '@/patterns/app-header';
import { Outlet } from 'react-router-dom';


const AppLayout = () => {
  return (
    <div className="flex">
      <SideBar />
      <div className='content-container h-screen'>
        <AppHeader />
        <div className='content-area'>
          <Outlet />
        </div>
        <AppFooter />
      </div>
    </div>
  );
}

export default AppLayout;