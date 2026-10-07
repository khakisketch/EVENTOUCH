ALTER TABLE stored_files ADD COLUMN width_px integer;
ALTER TABLE stored_files ADD COLUMN height_px integer;
ALTER TABLE stored_files ADD CONSTRAINT stored_file_dimensions CHECK (
  (width_px IS NULL AND height_px IS NULL) OR
  (width_px IS NOT NULL AND height_px IS NOT NULL AND width_px BETWEEN 1 AND 10000 AND height_px BETWEEN 1 AND 10000)
);
