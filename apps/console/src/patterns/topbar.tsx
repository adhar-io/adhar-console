import { RxSun, RxMoon, RxBell } from "react-icons/rx";

import useDarkMode from '@/hooks/useDarkMode';
import WorkSpaceSwitcher from "../pages/Home/ws-switcher";
import Profile from '../pages/Home/Profile';
import AdharConsoleLogo from "@/components/adhar-console-logo";
import Search from "../pages/Home/Search";
import { QuickAccess } from "../pages/Home/QuickAccess";
  
const Topbar = () => {

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

const WSSwitcher = () => (
  <div className='top-navigation-icon shadow-sm mr-2'>
      <WorkSpaceSwitcher />
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

export default Topbar;