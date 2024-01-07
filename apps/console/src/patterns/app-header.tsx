import { RxSun, RxDashboard, RxMoon, RxBell, RxMagnifyingGlass } from "react-icons/rx";

import useDarkMode from '@/hooks/useDarkMode';
import WorkSpaceSwitcher from "../pages/Home/ws-switcher";
import Profile from '../pages/Home/Profile';
import AdharConsoleLogo from "@/components/adhar-console-logo";
  
  const AppHeader = () => {
    return (
      <div className='top-navigation'>
        <Title />
        <Search />
        <WSSwitcher />
        <QuickAccess />
        <ThemeIcon />
        <Notifications />
        <UserProfile />
      </div>
    );
  };
  
  
  const Title = () => (
    <div className='console-logo'>
      <AdharConsoleLogo />
    </div>
  );

  const Search = () => (
    <div className='search'>
      <input className='search-input' type='text' placeholder='Search...' />
      <RxMagnifyingGlass size='22' className='text-gray-500 my-auto' />
    </div>
  );

  const WSSwitcher = () => (
    <div className='top-navigation-icon shadow-sm mr-2'>
        <WorkSpaceSwitcher />
    </div>
  );

  const QuickAccess = () => (
    <div className=''>
        <RxDashboard size='24' className='top-navigation-icon' />
    </div>
  );

  const ThemeIcon = () => {
    const [darkTheme, setDarkTheme] = useDarkMode();
    const handleMode = () => setDarkTheme(!darkTheme);
    return (
      <span onClick={handleMode}>
        {darkTheme ? (
          <RxSun size='24' className='top-navigation-icon' />
        ) : (
          <RxMoon size='24' className='top-navigation-icon' />
        )}
      </span>
    );
  };

  const Notifications = () => (
    <div className=''>
        <RxBell size='24' className='top-navigation-icon' />
    </div>
  );

  const UserProfile = () => (
    <div className='top-navigation-icon mr-6'>
        <Profile />
    </div>
  );
  
  export default AppHeader;