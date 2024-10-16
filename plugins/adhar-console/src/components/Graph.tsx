// Graph.tsx
import React from 'react';
import { LineChart, Line, CartesianGrid, Tooltip, ResponsiveContainer, Area, AreaChart } from 'recharts';

const data = [
  { name: 'Jan', velocity: 65 },
  { name: 'Feb', velocity: 59 },
  { name: 'Mar', velocity: 80 },
  { name: 'Apr', velocity: 81 },
  { name: 'May', velocity: 56 },
  { name: 'Jun', velocity: 55 },
  { name: 'Jul', velocity: 40 },
  { name: 'Aug', velocity: 70 },
  { name: 'Sep', velocity: 60 },
  { name: 'Oct', velocity: 90 },
  { name: 'Nov', velocity: 100 },
  { name: 'Dec', velocity: 75 },
];

export const Graph = () => {
  return (
    <ResponsiveContainer width="100%" height={400}>
      <AreaChart
        data={data}
        margin={{
          top: 20, right: 30, left: 20, bottom: 5,
        }}
      >
        <defs>
          <linearGradient id="colorVelocity" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#8884d8" stopOpacity={0.8} />
            <stop offset="95%" stopColor="#8884d8" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#444" />
        <Tooltip contentStyle={{ backgroundColor: '#333', border: 'none', color: '#fff' }} />
        <Area type="monotone" dataKey="velocity" stroke="#8884d8" fillOpacity={1} fill="url(#colorVelocity)" />
      </AreaChart>
    </ResponsiveContainer>
  );
};