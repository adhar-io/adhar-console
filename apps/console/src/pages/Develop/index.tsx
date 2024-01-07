import React from 'react';
import MenuBar from '../../patterns/menubar';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/resizable";

const Develop = () => {
  return (
    <div className="develop">
    <ResizablePanelGroup
      direction="horizontal"
      className=""
    >
      <ResizablePanel defaultSize={20} maxSize={25} >
        <div className="flex h-full w-80 items-center justify-center">
          <MenuBar title="Developer Hub" menuItems={null} />
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel>
        <ResizablePanelGroup direction="vertical">
          <ResizablePanel defaultSize={6}>
            <div className="flex h-full items-center justify-center">
              <span className="font-semibold">Tab bar</span>
            </div>
          </ResizablePanel>
          <ResizableHandle disabled />
          <ResizablePanel defaultSize={94}>
            <div className="flex h-full items-center justify-center p-6">
              <h1>Welcome to the Develop Page</h1>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
    </div>
  );
}

export default Develop;