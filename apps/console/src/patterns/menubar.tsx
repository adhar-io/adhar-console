import React from 'react';

interface MenuBarProps {
  title: string;
  menuItems: any[]; // replace any with the actual type of menuItems
}

const MenuBar: React.FC<MenuBarProps> = ({title, menuItems}) => {
  return (
    <div className='menu-bar h-screen'>
      <MenuTitleBlock title={title}/>
      <div className='menu-container'>
  
      </div>
    </div>
  );
};

interface MenuTitleBlockProps {
  title: string;
}

const MenuTitleBlock: React.FC<MenuTitleBlockProps> = ({title}) => (
  <div className='menu-block'>
    <h5 className='menu-block-text'>{title}</h5>
  </div>
);

export default MenuBar;