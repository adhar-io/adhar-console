import React from 'react';
import makeStyles from '@mui/styles/makeStyles';

type BrandIconProps = {
  logo: string;
};

const useStyles = makeStyles({
  img: {
    width: 'auto',
    height: 28,
  },
});

export const BrandIcon = ({logo}: BrandIconProps) => {
  const classes = useStyles();

  return (
    <img
      className={classes.img}
      src={logo}
      alt="App"
     />
  );
};
