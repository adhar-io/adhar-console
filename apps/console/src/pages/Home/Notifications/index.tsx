import { RxBell } from "react-icons/rx";
import { AlertCircle, Terminal,  CheckCircle} from "lucide-react";
import {
    Alert,
    AlertDescription,
    AlertTitle,
  } from "@/components/alert";
import { Separator } from "@/components/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/sheet";

function Notifications() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <RxBell size='24' className='top-navigation-icon' />
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Notifications</SheetTitle>
          <SheetDescription>
            See all your notifications here.
          </SheetDescription>
          <Separator className="my-2" />
        </SheetHeader>
        <div className="py-4">
          <div className="items-left">
            <Alert className="mb-2">
                <CheckCircle className="h-4 w-4" />
                <AlertTitle>Success</AlertTitle>
                <AlertDescription>
                    Your cluster has been scanned Successfully.
                </AlertDescription>
            </Alert>

            <Alert className="mb-2">
                <Terminal className="h-4 w-4" />
                <AlertTitle>Heads up!</AlertTitle>
                <AlertDescription>
                    You can add components and dependencies to your app using the cli.
                </AlertDescription>
            </Alert>

            <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>
                    Your session has expired. Please log in again.
                </AlertDescription>
            </Alert>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export default Notifications;