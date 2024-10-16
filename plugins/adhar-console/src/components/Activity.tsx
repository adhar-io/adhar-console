import React from 'react';
import { Card, CardContent, Typography } from '@material-ui/core';

export const Activity = () => {
  return (
    <Card>
      <CardContent>
        <Typography variant="h5" component="h2">
          Recent Activities
        </Typography>
        <Typography color="textSecondary">
          Activity 1: Description
        </Typography>
        <Typography color="textSecondary">
          Activity 2: Description
        </Typography>
        <Typography color="textSecondary">
          Activity 3: Description
        </Typography>
      </CardContent>
    </Card>
  );
};