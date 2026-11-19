DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (45581, 'FIFA 96', 'fifa-96'),
      (10682, 'FIFA 64', 'fifa-64'),
      (43335, 'FIFA 2003', 'fifa-2003'),
      (3136, 'FIFA 2004', 'fifa-2004'),
      (703, 'FIFA 2005', 'fifa-2005'),
      (700, 'FIFA 06', 'fifa-06'),
      (696, 'FIFA 07', 'fifa-07'),
      (3135, 'FIFA 08', 'fifa-08'),
      (3134, 'FIFA 09', 'fifa-09'),
      (3133, 'FIFA 10', 'fifa-10'),
      (503, 'FIFA 11', 'fifa-11'),
      (2946, 'FIFA 12', 'fifa-12'),
      (2153, 'FIFA 13', 'fifa-13')
    ) AS v(igdb_id, name, slug)
  LOOP
    UPDATE games_cache
    SET slug = slug || '-' || igdb_id
    WHERE slug = r.slug AND igdb_id <> r.igdb_id;

    UPDATE games_cache
    SET alternative_names = name || coalesce(' | ' || alternative_names, ''),
        name = r.name,
        slug = r.slug
    WHERE igdb_id = r.igdb_id AND name <> r.name;
  END LOOP;
END $$;
