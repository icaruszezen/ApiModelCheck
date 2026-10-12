import { Skeleton } from "@endfield-ui/react";

/** 首次加载时的骨架：只画页头、统计和两个渠道，每个渠道一行模型卡 */
export function BoardSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-12">
      <span role="status" className="sr-only">
        正在加载检测数据
      </span>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton variant="text" lines={2} className="max-w-prose text-sm" />
        <div className="mt-4 grid grid-cols-2 gap-6 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-16" />
          ))}
        </div>
      </div>
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-7 w-56 max-w-full" />
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }, (_, card) => (
              <Skeleton
                key={card}
                className={
                  ["h-96", "hidden h-96 md:block", "hidden h-96 xl:block"][card]
                }
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
