import React from 'react';
import SideBar from '@/patterns/sidebar';
import Topbar from '@/patterns/topbar';
import { Outlet } from 'react-router-dom';


const AppLayout = () => {
  return (
    <div className="flex">
      <SideBar />
      <div className='content-container h-screen'>
        <Topbar />
        <div className='content-area'>
          <Outlet />
        </div>
      </div>
    </div>
  );
}

export default AppLayout;