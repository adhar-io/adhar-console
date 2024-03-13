import { ReactNode } from 'react';
import { FaChartPie, FaSailboat, FaLayerGroup, FaFlask, FaPalette, FaGear } from "react-icons/fa6";
import Logo from "@/components/logo";
import { Link } from "react-router-dom";
import { useState } from "react";

const SideBar = () => {
    const [selectedItem, setSelectedItem] = useState('home');

    const getSelection = (item: string) => {
        return selectedItem === item;
    }

  return (
    <div className="fixed top-0 left-0 h-screen w-16 flex flex-col bg-white dark:bg-gray-900 shadow-lg">        
        <SideBarItem icon={<Logo selected={getSelection('home')} />} route="/" selected={getSelection('home')} onClick={() => setSelectedItem('home')} />
        <Divider />
        <SideBarItem icon={<FaLayerGroup size="20" />} label="Define" route="/define" selected={getSelection('define')} onClick={() => setSelectedItem('define')}/>
        <SideBarItem icon={<FaPalette size="20" />} label="Design" route="/design" selected={getSelection('design')} onClick={() => setSelectedItem('design')}/>
        <SideBarItem icon={<FaFlask size="20" />} label="Develop" route="/develop" selected={getSelection('develop')} onClick={() => setSelectedItem('develop')}/>
        <SideBarItem icon={<FaSailboat size="20" />} label="Deliver" route="/deliver" selected={getSelection('deliver')} onClick={() => setSelectedItem('deliver')}/>
        <SideBarItem icon={<FaChartPie size="20" />} label="Discover" route="/discover" selected={getSelection('discover')} onClick={() => setSelectedItem('discover')}/>
        <SideBarItem icon={<FaGear size="20" />} label="Admin" route="/admin" selected={getSelection('admin')} onClick={() => setSelectedItem('admin')}/>
        <div className="fixed bottom-0 mb-5 text-center w-16">
          <p className="version">v0.1.85</p>
          <Divider />
        </div>
    </div>
  );
};

interface SideBarItemProps {
  icon: ReactNode;
  label?: string;
  route: string;
  selected: boolean;
  [x: string]: any; // for the rest props
}

const SideBarItem: React.FC<SideBarItemProps> = ({ icon, label = '', route, selected, ...props }) => (
    <div className="sidebar-item" {...props}>
      <Link to={route}>
        <div className={`sidebar-icon ${selected ? 'bg-blue-600 text-white fill-white' : ''}`}>
            {icon}
        </div>
      </Link>
      <span className="sidebar-label">
        {label}
      </span>
    </div>
);

const Divider = () => <hr className="sidebar-hr" />;

export default SideBar;