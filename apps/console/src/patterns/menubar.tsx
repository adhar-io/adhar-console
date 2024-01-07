import { useState } from 'react';

const MenuBar = ({title, menuItems}) => {
  return (
    <div className='menu-bar h-screen'>
      <MenuTitleBlock title={title}/>
      <div className='menu-container'>
  
      </div>
    </div>
  );
};

const MenuTitleBlock = ({title}) => (
  <div className='menu-block'>
    <h5 className='menu-block-text'>{title}</h5>
  </div>
);

export default MenuBar;