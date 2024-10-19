import React, { PropsWithChildren } from 'react';
import { Box, makeStyles } from '@material-ui/core';
import ExtensionIcon from '@material-ui/icons/Extension';
import MapIcon from '@material-ui/icons/MyLocation';
import LibraryBooks from '@material-ui/icons/LibraryBooks';
import CreateComponentIcon from '@material-ui/icons/AddCircleOutline';
import { AdharFullLogo, AdharIcon } from '@internal/plugin-adhar-console';
import { Settings as SidebarSettings, UserSettingsSignInAvatar } from '@backstage/plugin-user-settings';
import { SidebarSearchModal } from '@backstage/plugin-search';
import {
  Sidebar,
  sidebarConfig,
  SidebarDivider,
  SidebarGroup,
  SidebarItem,
  SidebarPage,
  SidebarScrollWrapper,
  SidebarSpace,
  useSidebarOpenState,
  Link,
  SidebarExpandButton,
  SidebarSubmenu,
  SidebarSubmenuItem,
} from '@backstage/core-components';
import MenuIcon from '@material-ui/icons/Menu';
import SearchIcon from '@material-ui/icons/Search';
import CodeIcon from '@material-ui/icons/Code';
import DashboardIcon from '@material-ui/icons/Dashboard';
import DomainIcon from '@material-ui/icons/Domain';
import DonutSmallIcon from '@material-ui/icons/DonutSmall';
import FlashOnIcon from '@material-ui/icons/FlashOn';
import StyleIcon from '@material-ui/icons/Style';
import ReorderIcon from '@material-ui/icons/Reorder';
import PollIcon from '@material-ui/icons/Poll';
import ImportantDevicesIcon from '@material-ui/icons/ImportantDevices';
import FormatPaintIcon from '@material-ui/icons/FormatPaint';
import EmojiObjectsIcon from '@material-ui/icons/EmojiObjects';
import ExploreIcon from '@material-ui/icons/Explore';
import DialpadIcon from '@material-ui/icons/Dialpad';
import ColorLensIcon from '@material-ui/icons/ColorLens';
import CategoryIcon from '@material-ui/icons/Category';
import CasinoIcon from '@material-ui/icons/Casino';
import BusinessIcon from '@material-ui/icons/Business';
import BlurOnIcon from '@material-ui/icons/BlurOn';
import BallotIcon from '@material-ui/icons/Ballot';
import AssignmentIcon from '@material-ui/icons/Assignment';
import AppsIcon from '@material-ui/icons/Apps';
import AddCircleIcon from '@material-ui/icons/AddCircle';
// import AddIcon from '@material-ui/icons/Add';
// import AccountCircleIcon from '@material-ui/icons/AccountCircle';
// import AccountBalanceIcon from '@material-ui/icons/AccountBalance';
// import HouseIcon from '@material-ui/icons/House';
// import HowToRegIcon from '@material-ui/icons/HowToReg';
// import GradientIcon from '@material-ui/icons/Gradient';
// import HighlightOffIcon from '@material-ui/icons/HighlightOff';
// import QueryBuilderIcon from '@material-ui/icons/QueryBuilder';
// import PostAddIcon from '@material-ui/icons/PostAdd';
// import ListIcon from '@material-ui/icons/List';
// import ExitToAppIcon from '@material-ui/icons/ExitToApp';
// import FeaturedPlayListIcon from '@material-ui/icons/FeaturedPlayList';
// import EmojiEventsIcon from '@material-ui/icons/EmojiEvents';
// import EventNoteIcon from '@material-ui/icons/EventNote';

const useSidebarLogoStyles = makeStyles({
  root: {
    width: sidebarConfig.drawerWidthClosed,
    height: 3 * sidebarConfig.logoHeight,
    display: 'flex',
    flexFlow: 'row nowrap',
    alignItems: 'center',
    marginBottom: -14,
  },
  link: {
    width: sidebarConfig.drawerWidthClosed,
    marginLeft: 24,
  },
});

const SidebarLogo = () => {
  const classes = useSidebarLogoStyles();
  const { isOpen } = useSidebarOpenState();

  return (
    <div className={classes.root}>
      <Link to="/" underline="none" className={classes.link} aria-label="Home">
        {isOpen ? <AdharFullLogo /> : <AdharIcon />}
      </Link>
    </div>
  );
};

export const Root = ({ children }: PropsWithChildren<{}>) => (
  <SidebarPage>
    <Sidebar>
      <Box display="flex" justifyContent="space-between" alignItems="center" width="100%">
        <SidebarLogo />
        <Box width="60px">
          <SidebarExpandButton />
        </Box>
      </Box>
      <SidebarGroup label="Search" icon={<SearchIcon />} to="/search">
        <SidebarSearchModal />
      </SidebarGroup>
      <SidebarDivider />
      <SidebarGroup label="Menu" icon={<MenuIcon />}>
        {/* Global nav, not org-specific */}
        <SidebarItem icon={CategoryIcon} to="catalog" text="Catalog" />
        <SidebarItem icon={ExtensionIcon} to="api-docs" text="APIs" />
        <SidebarItem icon={LibraryBooks} to="docs" text="Docs" />
        {/* End global nav */}
        <SidebarItem icon={CreateComponentIcon} to="create" text="Create..." />
      </SidebarGroup>
      <SidebarDivider />

      <SidebarItem icon={DomainIcon} text="Define" >
        <SidebarSubmenu title="🎯 Define" >
          <SidebarDivider />
          <SidebarSubmenuItem icon={AppsIcon} title="Applications"/>
          <SidebarSubmenuItem icon={BlurOnIcon} title="Timelines" />
          <SidebarSubmenuItem icon={ReorderIcon} title="Functional Specifications" />
        </SidebarSubmenu>
      </SidebarItem>

      <SidebarItem icon={StyleIcon} text="Design" >
        <SidebarSubmenu title="💅 Design" >
          <SidebarDivider />
          <SidebarSubmenuItem icon={ColorLensIcon} title="Design System"/>
          <SidebarSubmenuItem icon={FormatPaintIcon} title="Canvas" />
          <SidebarSubmenuItem icon={BusinessIcon} title="Technical Specifications" />
          <SidebarSubmenuItem icon={AddCircleIcon} title="Architectural Decision Records" />
        </SidebarSubmenu>
      </SidebarItem>

      <SidebarItem icon={CodeIcon} text="Develop" >
        <SidebarSubmenu title="👨‍💻 Develop" >
          <SidebarDivider />
          <SidebarSubmenuItem icon={ImportantDevicesIcon} title="Repositories"/>
          <SidebarSubmenuItem icon={PollIcon} title="Image Registry" />
          <SidebarSubmenuItem icon={AssignmentIcon} title="Pipelines" />
        </SidebarSubmenu>
      </SidebarItem>

      <SidebarItem icon={FlashOnIcon} text="Deliver" >
        <SidebarSubmenu title="🚀 Deliver" >
          <SidebarDivider />
          <SidebarSubmenuItem icon={DialpadIcon} title="Environments"/>
          <SidebarSubmenuItem icon={CasinoIcon} title="Releases" />
          <SidebarSubmenuItem icon={BallotIcon} title="Monitor" />
        </SidebarSubmenu>
      </SidebarItem>

      <SidebarItem icon={DashboardIcon} text="Discover" hasSubmenu >
        <SidebarSubmenu title="✨ Discover" >
          <SidebarDivider />
          <SidebarSubmenuItem icon={DonutSmallIcon} title="Analytics"/>
          <SidebarSubmenuItem icon={EmojiObjectsIcon} title="Insights" />
          <SidebarSubmenuItem icon={ExploreIcon} title="Explorer" />
        </SidebarSubmenu>
      </SidebarItem>

      <SidebarDivider />
      <SidebarScrollWrapper>
        <SidebarItem icon={MapIcon} to="tech-radar" text="Tech Radar" />
      </SidebarScrollWrapper>

      <SidebarSpace />
      <SidebarDivider />
      <SidebarGroup
        label="Settings"
        icon={<UserSettingsSignInAvatar />}
        to="/settings"
      >
        <SidebarSettings />
      </SidebarGroup>
    </Sidebar>
    {children}
  </SidebarPage>
);
