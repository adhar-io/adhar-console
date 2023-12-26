import React from 'react';
import { FaWandMagicSparkles } from 'react-icons/fa6';
const App = () => {

  const buttonHandler = () => {
    alert('Assist clicked!');
  }

  return (
    <div className="assist" onClick={buttonHandler} title="Assist">
      <FaWandMagicSparkles size="24" />
    </div>
  );
}

export default App;