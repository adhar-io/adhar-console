import React from 'react';
import MenuBar from '../../patterns/menubar';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/resizable";

const Design = () => {
  return (
    <div className="design">
    <ResizablePanelGroup
      direction="horizontal"
      className=""
    >
      <ResizablePanel defaultSize={15} maxSize={19}>
        <div className="flex h-full w-80 items-center justify-center">
          <MenuBar title="Design Hub" menuItems={null} />
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
              <h1>Welcome to the Design Page</h1>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
    </div>
  );
}

export default Design;