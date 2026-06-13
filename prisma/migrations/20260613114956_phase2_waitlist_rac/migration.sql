-- AlterTable
ALTER TABLE "booking_passengers" ADD COLUMN     "rac_position" INTEGER,
ADD COLUMN     "waitlist_position" INTEGER;

-- CreateTable
CREATE TABLE "coach_class_configs" (
    "id" TEXT NOT NULL,
    "train_id" TEXT NOT NULL,
    "class_type" "ClassType" NOT NULL,
    "rac_capacity" INTEGER NOT NULL,
    "max_waitlist" INTEGER NOT NULL,

    CONSTRAINT "coach_class_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coach_class_configs_train_id_class_type_key" ON "coach_class_configs"("train_id", "class_type");

-- AddForeignKey
ALTER TABLE "coach_class_configs" ADD CONSTRAINT "coach_class_configs_train_id_fkey" FOREIGN KEY ("train_id") REFERENCES "trains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
