import { appConfig } from "@/config/app-config"

 const AppFooter = () => {
    const currentYear = new Date().getFullYear();

    return (
        <div className="py-6 md:px-8 md:py-0 bg-primary dark:bg-gray-800 justify-center w-full">
            <div className="container flex flex-col items-center justify-between gap-4 md:h-24 md:flex-row text-center w-full">
                <p className="text-balance text-sm leading-loose text-muted-foreground text-center w-full">
                    © {currentYear} Anitech Consulting Services Pvt Ltd. All rights reserved.
                </p>
            </div>
        </div>
    )
}

export default AppFooter;