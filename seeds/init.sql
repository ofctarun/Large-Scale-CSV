-- Create the users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    signup_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    country_code CHAR(2) NOT NULL,
    subscription_tier VARCHAR(50) DEFAULT 'free',
    lifetime_value NUMERIC(10, 2) DEFAULT 0.00
);

-- Add indexes for efficient filtering
CREATE INDEX idx_users_country_code ON users(country_code);
CREATE INDEX idx_users_subscription_tier ON users(subscription_tier);
CREATE INDEX idx_users_lifetime_value ON users(lifetime_value);

-- Seed 10 million rows using generate_series for maximum performance
-- Country codes pool
DO $$
DECLARE
    countries TEXT[] := ARRAY['US','GB','CA','AU','DE','FR','IN','JP','BR','MX','IT','ES','NL','SE','NO','DK','FI','PL','RU','CN','KR','SG','NZ','ZA','AR'];
    tiers TEXT[] := ARRAY['free','basic','premium','enterprise'];
    batch_size INT := 500000;
    total_rows INT := 10000000;
    current_offset INT := 0;
BEGIN
    WHILE current_offset < total_rows LOOP
        INSERT INTO users (name, email, signup_date, country_code, subscription_tier, lifetime_value)
        SELECT
            'User_' || gs AS name,
            'user_' || gs || '@example.com' AS email,
            CURRENT_TIMESTAMP - (random() * INTERVAL '1095 days') AS signup_date,
            countries[1 + floor(random() * array_length(countries, 1))::int] AS country_code,
            tiers[1 + floor(random() * array_length(tiers, 1))::int] AS subscription_tier,
            round((random() * 5000)::numeric, 2) AS lifetime_value
        FROM generate_series(current_offset + 1, LEAST(current_offset + batch_size, total_rows)) AS gs;

        current_offset := current_offset + batch_size;
        RAISE NOTICE 'Inserted % rows...', current_offset;
    END LOOP;
END $$;

-- Analyze table for optimal query planning
ANALYZE users;
