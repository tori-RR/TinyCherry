package main

import "testing"

func TestVersionFourFreshProfileUsesApprovalProtectedDefault(t *testing.T) {
	s, _ := testServer(t)
	enabled, err := s.store.preference(computerPreference)
	if err != nil || enabled != true {
		t.Fatalf("fresh profile did not adopt upstream's enabled default: got %v error %v", enabled, err)
	}
	value, err := s.store.preference(approvedComputerAppsPreference)
	apps, validationErr := computerApprovedApps(value)
	if err != nil || validationErr != nil || len(apps) != 0 {
		t.Fatal("fresh profile must require approval for every app", err, validationErr)
	}
}

func TestVersionFourPreservesExistingDesktopPreference(t *testing.T) {
	for _, legacy := range []struct {
		name, stored string
		expected     bool
	}{
		{name: "absent remains disabled"},
		{name: "explicit disabled", stored: "false"},
		{name: "explicit enabled", stored: "true", expected: true},
	} {
		t.Run(legacy.name, func(t *testing.T) {
			s, directory := testServer(t)
			if _, err := s.store.db.Exec("DELETE FROM preference WHERE key=?", computerPreference); err != nil {
				t.Fatal(err)
			}
			if legacy.stored != "" {
				if _, err := s.store.db.Exec("INSERT INTO preference(key,value) VALUES(?,?)", computerPreference, legacy.stored); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.store.db.Exec("PRAGMA user_version=3"); err != nil {
				t.Fatal(err)
			}
			s.store.db.Close()
			for reopen := 0; reopen < 2; reopen++ {
				repository, err := openStore(directory)
				if err != nil {
					t.Fatal(err)
				}
				actual, err := repository.preference(computerPreference)
				if err != nil || actual != legacy.expected {
					t.Fatalf("desktop preference changed on reopen %d: got %v error %v", reopen, actual, err)
				}
				var version int
				if err := repository.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 4 {
					t.Fatalf("schema migration not committed: version %d error %v", version, err)
				}
				repository.db.Close()
			}
		})
	}
}
