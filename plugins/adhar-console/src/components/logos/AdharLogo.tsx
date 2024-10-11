import React from 'react';
import { makeStyles } from '@material-ui/core';

const useStyles = makeStyles({
  svg: {
    width: 'auto',
    height: 28,
  },
  whitePath: {
    fill: '#ffffff',
    stroke: 'none',
  },
  bluePath: {
    fill: '#00568c',
    stroke: 'none',
  },
  cyanPath: {
    fill: '#00adee',
    stroke: 'none',
  },
});

export const AdharLogo = () => {
  const classes = useStyles();

  return (
    <svg id="logo" className={classes.svg} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2079.95 850.05">
      <path className={classes.cyanPath}
          d="M496.53,410.49H484.28L506.61,354c2.35-5.94,6.68-8.2,13.37-8.2s10.93,2.26,13.19,8.2l21.48,56.52H542.31L523,359.34a3,3,0,0,0-3.11-2.17,3.22,3.22,0,0,0-3.21,2.17Z" />
      <path className={classes.cyanPath}
          d="M593.65,346.9c18.56,0,28.64,10.37,28.64,31.84s-10,31.75-28.64,31.75H571.23c-3.58,0-5.27-1.7-5.27-5.18V352.08c0-3.48,1.69-5.18,5.27-5.18Zm-16.58,51.34c0,.85.38,1.13,1.23,1.13h15.35c12.34,0,17.52-6.12,17.52-20.72S606,358,593.65,358H578.3c-.85,0-1.23.28-1.23,1.13Z" />
      <path className={classes.cyanPath} 
          d="M648.39,346.9v25.91h32.5V346.9H692.1v63.59H680.89V383.92h-32.5v26.57H637.28V346.9Z" />
      <path className={classes.cyanPath}
          d="M715.66,410.49H703.41L725.73,354c2.36-5.94,6.69-8.2,13.38-8.2S750,348,752.3,354l21.47,56.52H761.43l-19.31-51.15a3,3,0,0,0-3.1-2.17,3.22,3.22,0,0,0-3.21,2.17Z" />
      <path className={classes.cyanPath}
          d="M819.37,346.9c14.32,0,20.45,8.86,20.45,19,0,7.91-3.77,16.39-13.47,19.12l14.78,25.44H828.79l-14.5-24.59H797.71a1.4,1.4,0,0,0-1.6,1.6v23H785V385.34c0-7.16,3-10.08,10-10.08h24.77c6.31,0,8.85-4.34,8.85-8.86s-2.73-8.38-8.85-8.38H784.9V346.9Z" />
  </svg>
  );
};
